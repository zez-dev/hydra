/**
 * The folder-backed {@link JournalStore}: `<dir>/<slug>/journal.md` per research
 * goal with YAML frontmatter and fixed Markdown sections, written atomically,
 * indexed in memory, and watched so edits made outside the harness are picked up.
 * @module
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import chokidar from 'chokidar'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {
  ExperimentDetails, ExperimentEntry, HypothesisEntry, HypothesisStatus, Journal, JournalEntry, JournalEntrySource, JournalInput,
  JournalStatus, JournalStore,
} from './types.ts'

const STATUSES: readonly JournalStatus[] = ['active', 'paused', 'done']
const SOURCES: readonly JournalEntrySource[] = ['model', 'auto', 'human']
const HYPOTHESIS_STATUSES: readonly HypothesisStatus[] = ['open', 'supported', 'refuted']
const SECTIONS = ['Breakthroughs', 'Hypotheses', 'Experiments', 'Dead ends', 'Next steps'] as const
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/u

/** Own writes remembered per file; more than the writes one burst of journal updates makes before the watcher catches up. */
const OWN_WRITES_KEPT = 16
/** Separates an experiment's action from its result on one line. */
const RESULT_SEPARATOR = ' => '
/** File name of every journal. */
export const JOURNAL_FILE = 'journal.md'

/**
 * Derive a journal slug from free text: lowercase, hyphens, at most 60 characters.
 * @param text - an objective or a user-supplied slug.
 * @returns a slug; `research` when nothing usable remains.
 */
export function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60).replace(/-+$/u, '')
  return slug.length === 0 ? 'research' : slug
}

function entryLine(entry: JournalEntry): string {
  return `- [${entry.id} ${entry.at} ${entry.source}] ${entry.text}`
}

/**
 * Render a journal as its Markdown file.
 * @param journal - the journal.
 * @returns the file contents.
 */
export function renderJournalFile(journal: Journal): string {
  const front = {
    slug: journal.slug,
    objective: journal.objective,
    criteria: [...journal.criteria],
    status: journal.status,
    createdAt: journal.createdAt,
    updatedAt: journal.updatedAt,
    sessions: [...journal.sessions],
  }
  return [
    '---',
    stringifyYaml(front).trimEnd(),
    '---',
    '',
    `# ${journal.objective}`,
    '',
    '## Breakthroughs',
    '',
    ...journal.breakthroughs.map(entryLine),
    '',
    '## Hypotheses',
    '',
    ...journal.hypotheses.map(entry => `- [${entry.id} ${entry.at} ${entry.source} ${entry.status}] ${entry.text}${scoreSuffix(entry)}`),
    '',
    '## Experiments',
    '',
    ...journal.experiments.map(entry => `- [${entry.id} ${entry.at} ${entry.source}] ${entry.what}${RESULT_SEPARATOR}${entry.result}${experimentSuffix(entry)}`),
    '',
    '## Dead ends',
    '',
    ...journal.deadEnds.map(entryLine),
    '',
    '## Next steps',
    '',
    ...journal.nextSteps.map(step => `- ${step}`),
    '',
  ].join('\n')
}

/** Separates an entry's text from the structured suffixes appended by scoring and `run_experiment`. */
const SUFFIX_SEPARATOR = ' ~ '

function scoreSuffix(entry: HypothesisEntry): string {
  if (entry.score === undefined) return ''
  const reason = entry.scoreReason === undefined || entry.scoreReason.length === 0 ? '' : ` (${entry.scoreReason})`
  return `${SUFFIX_SEPARATOR}score: ${entry.score}${reason}`
}

function experimentSuffix(entry: ExperimentEntry): string {
  const parts: string[] = []
  if (entry.title !== undefined) parts.push(`title: ${entry.title}`)
  if (entry.hypothesisId !== undefined) parts.push(`hypothesis: ${entry.hypothesisId}`)
  if (entry.metrics !== undefined && Object.keys(entry.metrics).length > 0) {
    parts.push(`metrics: ${Object.entries(entry.metrics).map(([name, value]) => `${name}=${value}`).join(', ')}`)
  }
  return parts.map(part => `${SUFFIX_SEPARATOR}${part}`).join('')
}

/**
 * Split an entry's text from its trailing ` ~ key: value` suffixes.
 * @param text - the entry text after the bracket.
 * @returns the bare text and the suffixes by key.
 */
function splitSuffixes(text: string): { text: string; suffixes: Map<string, string> } {
  const suffixes = new Map<string, string>()
  let rest = text
  for (;;) {
    const index = rest.lastIndexOf(SUFFIX_SEPARATOR)
    if (index === -1) break
    const tail = rest.slice(index + SUFFIX_SEPARATOR.length)
    const colon = tail.indexOf(': ')
    if (colon === -1 || !/^[a-z]+$/u.test(tail.slice(0, colon))) break
    suffixes.set(tail.slice(0, colon), tail.slice(colon + 2).trim())
    rest = rest.slice(0, index)
  }
  return { text: rest.trim(), suffixes }
}

function parseScore(value: string | undefined): { score: number; scoreReason?: string } | undefined {
  if (value === undefined) return undefined
  const match = /^(?<score>[0-9.]+)(?: \((?<reason>.*)\))?$/u.exec(value)
  const score = Number(match?.groups?.['score'])
  if (match === null || !Number.isFinite(score) || score < 0 || score > 1) return undefined
  const reason = match.groups?.['reason']
  return reason === undefined ? { score } : { score, scoreReason: reason }
}

function parseMetrics(value: string | undefined): Record<string, number> | undefined {
  if (value === undefined) return undefined
  const metrics: Record<string, number> = {}
  for (const part of value.split(',')) {
    const [name, raw] = part.split('=').map(item => item.trim())
    const number = Number(raw)
    if (name !== undefined && name.length > 0 && raw !== undefined && Number.isFinite(number)) metrics[name] = number
  }
  return metrics
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`journal frontmatter ${key} must be a non-empty string`)
  return value
}

function stringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`journal frontmatter ${key} must be a list of strings`)
  return value as string[]
}

function enumOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  if (!allowed.includes(value as T)) throw new Error(`journal ${what} must be one of ${allowed.join(', ')}`)
  return value as T
}

const ENTRY = /^- \[(?<id>[bdeh]-[0-9a-f]+) (?<at>\S+) (?<source>model|auto|human)(?: (?<status>open|supported|refuted))?\] (?<text>.*)$/u

/** One parsed entry line before its section decides the entry type. */
interface ParsedEntry {
  readonly id: string
  readonly at: string
  readonly source: JournalEntrySource
  readonly status?: HypothesisStatus
  readonly text: string
}

function parseEntry(line: string, section: string): ParsedEntry | undefined {
  const groups = ENTRY.exec(line)?.groups
  const id = groups?.['id']
  const at = groups?.['at']
  const rawSource = groups?.['source']
  const text = groups?.['text']
  if (id === undefined || at === undefined || rawSource === undefined || text === undefined) return undefined
  const status = groups?.['status']
  return {
    id,
    at,
    source: enumOf(rawSource, SOURCES, `${section} source`),
    ...status === undefined ? {} : { status: enumOf(status, HYPOTHESIS_STATUSES, 'hypothesis status') },
    text: text.trim(),
  }
}

/**
 * Parse a journal file.
 * @param text - the file contents.
 * @returns the journal.
 * @throws when the frontmatter or an entry line is malformed.
 */
export function parseJournalFile(text: string): Journal {
  const match = /^---\r?\n(?<front>[\s\S]*?)\r?\n---\r?\n(?<body>[\s\S]*)$/u.exec(text)
  const frontText = match?.groups?.['front']
  const body = match?.groups?.['body']
  if (frontText === undefined || body === undefined) throw new Error('journal file must start with YAML frontmatter')
  const front: unknown = parseYaml(frontText)
  if (front === null || typeof front !== 'object' || Array.isArray(front)) throw new Error('journal frontmatter must be a mapping')
  const record = front as Record<string, unknown>
  const sections = new Map<string, string[]>()
  let current: string | undefined
  for (const line of body.split(/\r?\n/u)) {
    const heading = /^## (?<name>.+)$/u.exec(line)?.groups?.['name']?.trim()
    if (heading !== undefined && (SECTIONS as readonly string[]).includes(heading)) {
      current = heading
      sections.set(current, [])
      continue
    }
    if (current !== undefined && line.startsWith('- ')) sections.get(current)?.push(line)
  }
  const breakthroughs: JournalEntry[] = []
  for (const line of sections.get('Breakthroughs') ?? []) {
    const entry = parseEntry(line, 'breakthrough')
    if (entry !== undefined) breakthroughs.push({ id: entry.id, at: entry.at, source: entry.source, text: entry.text })
  }
  const hypotheses: HypothesisEntry[] = []
  for (const line of sections.get('Hypotheses') ?? []) {
    const entry = parseEntry(line, 'hypothesis')
    if (entry === undefined) continue
    const { text: bare, suffixes } = splitSuffixes(entry.text)
    const scored = parseScore(suffixes.get('score'))
    hypotheses.push({ id: entry.id, at: entry.at, source: entry.source, text: bare, status: entry.status ?? 'open', ...scored ?? {} })
  }
  const experiments: ExperimentEntry[] = []
  for (const line of sections.get('Experiments') ?? []) {
    const entry = parseEntry(line, 'experiment')
    if (entry === undefined) continue
    const { text: bare, suffixes } = splitSuffixes(entry.text)
    const separator = bare.indexOf(RESULT_SEPARATOR)
    const what = separator === -1 ? bare : bare.slice(0, separator).trim()
    const result = separator === -1 ? '' : bare.slice(separator + RESULT_SEPARATOR.length).trim()
    const title = suffixes.get('title')
    const hypothesisId = suffixes.get('hypothesis')
    const metrics = parseMetrics(suffixes.get('metrics'))
    experiments.push({
      id: entry.id, at: entry.at, source: entry.source, what, result,
      ...title === undefined ? {} : { title },
      ...hypothesisId === undefined ? {} : { hypothesisId },
      ...metrics === undefined ? {} : { metrics },
    })
  }
  const deadEnds: JournalEntry[] = []
  for (const line of sections.get('Dead ends') ?? []) {
    const entry = parseEntry(line, 'dead end')
    if (entry !== undefined) deadEnds.push({ id: entry.id, at: entry.at, source: entry.source, text: entry.text })
  }
  const nextSteps = (sections.get('Next steps') ?? []).map(line => line.replace(/^-\s*/u, '').trim()).filter(step => step.length > 0)
  return {
    slug: stringField(record, 'slug'),
    objective: stringField(record, 'objective'),
    criteria: stringList(record, 'criteria'),
    status: enumOf(stringField(record, 'status'), STATUSES, 'status'),
    createdAt: stringField(record, 'createdAt'),
    updatedAt: stringField(record, 'updatedAt'),
    sessions: stringList(record, 'sessions'),
    breakthroughs,
    hypotheses,
    experiments,
    deadEnds,
    nextSteps,
  }
}

function newId(prefix: 'b' | 'h' | 'e' | 'd'): string {
  return `${prefix}-${randomBytes(3).toString('hex')}`
}

/** {@link JournalStore} over one research directory. */
export class FolderJournalStore implements JournalStore {
  readonly dir: string
  private readonly journals = new Map<string, Journal>()
  private readonly listeners = new Set<(slug: string) => void>()
  private watcher: ReturnType<typeof chokidar.watch> | undefined
  /**
   * The latest texts this process wrote to each file, newest last. The watcher
   * can report a write after a later one has landed; re-reading any of them
   * would replace the journal with an older state, so all are skipped. An
   * outside edit that restores one of these exact texts is skipped too.
   */
  private readonly ownWrites = new Map<string, string[]>()
  private ready: Promise<void> | undefined

  /**
   * @param dir - absolute or relative research directory; relative resolves against the process cwd.
   */
  constructor(dir: string) {
    this.dir = resolve(dir)
  }

  open(): Promise<void> {
    this.ready ??= this.doOpen()
    return this.ready
  }

  whenReady(): Promise<void> {
    return this.ready ?? Promise.reject(new Error(`research journal store ${this.dir} is not open`))
  }

  private pathOf(slug: string): string {
    return join(this.dir, slug, JOURNAL_FILE)
  }

  private async doOpen(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    for (const name of await readdir(this.dir)) {
      if (SLUG.test(name)) await this.load(this.pathOf(name))
    }
    this.watcher = chokidar.watch(this.dir, { ignoreInitial: true, depth: 1 })
    const onFile = (path: string): void => {
      if (basename(path) !== JOURNAL_FILE) return
      void this.load(path).then((slug) => { if (slug !== undefined) this.notify(slug) })
    }
    this.watcher.on('add', onFile)
    this.watcher.on('change', onFile)
    this.watcher.on('unlink', (path: string) => {
      if (basename(path) !== JOURNAL_FILE) return
      const slug = basename(dirname(path))
      if (this.journals.delete(slug)) this.notify(slug)
    })
  }

  async close(): Promise<void> {
    await this.watcher?.close()
    this.watcher = undefined
  }

  private async load(path: string): Promise<string | undefined> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      // Removed between the event and the read; the unlink handler owns it.
      return undefined
    }
    if (this.ownWrites.get(path)?.includes(text) === true) return undefined
    try {
      const journal = parseJournalFile(text)
      this.journals.set(journal.slug, journal)
      return journal.slug
    } catch {
      // A malformed or half-written file is skipped until it parses; the next change re-reads it.
      return undefined
    }
  }

  private notify(slug: string): void {
    for (const listener of this.listeners) listener(slug)
  }

  private async write(journal: Journal): Promise<void> {
    const path = this.pathOf(journal.slug)
    await mkdir(dirname(path), { recursive: true })
    const text = renderJournalFile(journal)
    this.ownWrites.set(path, [...this.ownWrites.get(path) ?? [], text].slice(-OWN_WRITES_KEPT))
    await writeFileAtomic(path, text, { mode: 0o644 })
    this.journals.set(journal.slug, journal)
    this.notify(journal.slug)
  }

  list(): Journal[] {
    return [...this.journals.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug))
  }

  get(slug: string): Journal | undefined {
    return this.journals.get(slug)
  }

  private require(slug: string): Journal {
    const journal = this.journals.get(slug)
    if (journal === undefined) throw new Error(`no research journal "${slug}" under ${this.dir}`)
    return journal
  }

  private async mutate(slug: string, change: (journal: Journal) => Journal): Promise<Journal> {
    await this.whenReady()
    const next = { ...change(this.require(slug)), updatedAt: new Date().toISOString() }
    await this.write(next)
    return next
  }

  async create(input: JournalInput): Promise<Journal> {
    await this.whenReady()
    if (!SLUG.test(input.slug)) throw new Error(`research slug "${input.slug}" must be lowercase letters, digits, and hyphens`)
    if (this.journals.has(input.slug)) throw new Error(`research journal "${input.slug}" already exists`)
    const objective = input.objective.trim()
    if (objective.length === 0) throw new Error('a research journal needs an objective')
    const now = new Date().toISOString()
    const journal: Journal = {
      slug: input.slug,
      objective,
      criteria: input.criteria.map(criterion => criterion.trim()).filter(criterion => criterion.length > 0),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      sessions: [],
      breakthroughs: [],
      hypotheses: [],
      experiments: [],
      deadEnds: [],
      nextSteps: [],
    }
    await this.write(journal)
    return journal
  }

  private static text(text: string, what: string): string {
    const trimmed = text.trim().replace(/\s*\n\s*/gu, ' ')
    if (trimmed.length === 0) throw new Error(`a ${what} needs text`)
    return trimmed
  }

  async addBreakthrough(slug: string, text: string, source: JournalEntrySource): Promise<JournalEntry> {
    const entry: JournalEntry = { id: newId('b'), at: new Date().toISOString(), source, text: FolderJournalStore.text(text, 'breakthrough') }
    await this.mutate(slug, journal => ({ ...journal, breakthroughs: [...journal.breakthroughs, entry] }))
    return entry
  }

  async addHypothesis(slug: string, text: string, source: JournalEntrySource): Promise<HypothesisEntry> {
    const entry: HypothesisEntry = { id: newId('h'), at: new Date().toISOString(), source, text: FolderJournalStore.text(text, 'hypothesis'), status: 'open' }
    await this.mutate(slug, journal => ({ ...journal, hypotheses: [...journal.hypotheses, entry] }))
    return entry
  }

  async setHypothesis(slug: string, id: string, status: HypothesisStatus): Promise<HypothesisEntry> {
    const journal = await this.mutate(slug, (current) => {
      if (!current.hypotheses.some(entry => entry.id === id)) throw new Error(`no hypothesis ${id} in "${slug}"`)
      return { ...current, hypotheses: current.hypotheses.map(entry => entry.id === id ? { ...entry, status } : entry) }
    })
    const updated = journal.hypotheses.find(entry => entry.id === id)
    if (updated === undefined) throw new Error(`no hypothesis ${id} in "${slug}"`)
    return updated
  }

  async addExperiment(
    slug: string, what: string, result: string, source: JournalEntrySource, details: ExperimentDetails = {},
  ): Promise<ExperimentEntry> {
    const entry: ExperimentEntry = {
      id: newId('e'),
      at: new Date().toISOString(),
      source,
      what: FolderJournalStore.text(what, 'experiment'),
      result: FolderJournalStore.text(result, 'experiment result'),
      ...details.title === undefined ? {} : { title: FolderJournalStore.text(details.title, 'experiment title') },
      ...details.hypothesisId === undefined ? {} : { hypothesisId: details.hypothesisId },
      ...details.metrics === undefined ? {} : { metrics: { ...details.metrics } },
    }
    await this.mutate(slug, journal => ({ ...journal, experiments: [...journal.experiments, entry] }))
    return entry
  }

  async setHypothesisScore(slug: string, id: string, score: number, reason: string): Promise<HypothesisEntry> {
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error(`hypothesis score must be within [0, 1], got ${String(score)}`)
    const scoreReason = reason.trim().replace(/\s*\n\s*/gu, ' ').replace(/[()]/gu, '')
    const journal = await this.mutate(slug, (current) => {
      if (!current.hypotheses.some(entry => entry.id === id)) throw new Error(`no hypothesis ${id} in "${slug}"`)
      return { ...current, hypotheses: current.hypotheses.map(entry => entry.id === id ? { ...entry, score, scoreReason } : entry) }
    })
    const updated = journal.hypotheses.find(entry => entry.id === id)
    if (updated === undefined) throw new Error(`no hypothesis ${id} in "${slug}"`)
    return updated
  }

  async addDeadEnd(slug: string, text: string, source: JournalEntrySource): Promise<JournalEntry> {
    const entry: JournalEntry = { id: newId('d'), at: new Date().toISOString(), source, text: FolderJournalStore.text(text, 'dead end') }
    await this.mutate(slug, journal => ({ ...journal, deadEnds: [...journal.deadEnds, entry] }))
    return entry
  }

  setNextSteps(slug: string, steps: readonly string[]): Promise<Journal> {
    const cleaned = steps.map(step => step.trim().replace(/\s*\n\s*/gu, ' ')).filter(step => step.length > 0)
    return this.mutate(slug, journal => ({ ...journal, nextSteps: cleaned }))
  }

  setStatus(slug: string, status: JournalStatus): Promise<Journal> {
    return this.mutate(slug, journal => ({ ...journal, status }))
  }

  attachSession(slug: string, sessionId: string): Promise<Journal> {
    return this.mutate(slug, journal => journal.sessions.includes(sessionId)
      ? journal
      : { ...journal, sessions: [...journal.sessions, sessionId] })
  }

  onChange(listener: (slug: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
