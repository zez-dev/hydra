/**
 * Turn evidence and its findings: which files a turn read only in part, which
 * files it changed after its last check command, and how many tool calls it
 * made, folded from the turn's logged tool calls and results. Every function
 * here is pure over the values it receives; durable `meta` and argument values
 * are validated before use because they arrive from the session log.
 * @module @deepseek-ai/dsh-evidence-guard/findings
 */

/** One inclusive, 1-based line range that a read returned. */
export type LineRange = readonly [first: number, last: number]

/** One file's read coverage within a turn. */
export interface FileReads {
  /** Every range the turn's reads returned, in arrival order. */
  readonly ranges: LineRange[]
  /** The file's line count at the latest read. */
  totalLines: number
}

/** What one turn's logged tool activity shows. */
export interface TurnEvidence {
  /** Tool calls the turn made, PTC sub-calls included. */
  toolCalls: number
  /** Read coverage per file path. */
  readonly reads: Map<string, FileReads>
  /** Files the turn wrote whole, whose content the model authored. */
  readonly written: Set<string>
  /** Files the turn changed through edit or write, in first-change order. */
  readonly changed: Set<string>
  /** Ordinal of the latest successful change; `0` when the turn changed nothing. */
  lastChange: number
  /** Ordinal of the latest check command; `0` when the turn ran none. */
  lastCheck: number
  /** Monotonic ordinal shared by changes and checks. */
  ordinal: number
}

/** A file the turn read only in part. */
export interface PartialRead {
  readonly path: string
  /** Merged ranges the turn read. */
  readonly read: readonly LineRange[]
  readonly totalLines: number
  /** Lines the turn did not read. */
  readonly unread: number
}

/** The review findings for one completed turn. */
export interface Findings {
  readonly partialReads: readonly PartialRead[]
  /** Changed files, when no check command ran after the last change; otherwise empty. */
  readonly uncheckedChanges: readonly string[]
  readonly toolCalls: number
}

/** Thresholds that decide whether a turn warrants a review. */
export interface FindingThresholds {
  /** A partly read file counts only when at least this many lines went unread. */
  readonly minUnreadLines: number
  /** A turn with at least this many tool calls is reviewed even without other findings. */
  readonly reviewAfterToolCalls: number
}

/** Files named in one review line before the rest are summarized as a count. */
const MAX_LISTED_FILES = 5

/**
 * Start an empty evidence record for a new turn.
 * @returns evidence with no tool calls, reads, changes, or checks.
 */
export function createTurnEvidence(): TurnEvidence {
  return { toolCalls: 0, reads: new Map(), written: new Set(), changed: new Set(), lastChange: 0, lastCheck: 0, ordinal: 0 }
}

/**
 * Record one read window.
 * @param evidence - the turn's evidence record.
 * @param path - the file path the read reported.
 * @param range - the inclusive line range the read returned.
 * @param totalLines - the file's line count when it was read.
 */
export function recordRead(evidence: TurnEvidence, path: string, range: LineRange, totalLines: number): void {
  const entry = evidence.reads.get(path)
  if (entry === undefined) {
    evidence.reads.set(path, { ranges: [range], totalLines })
    return
  }
  entry.ranges.push(range)
  entry.totalLines = totalLines
}

/**
 * Record one successful file change.
 * @param evidence - the turn's evidence record.
 * @param path - the changed file's path.
 * @param whole - whether the change wrote the whole file, so the model authored its content.
 */
export function recordChange(evidence: TurnEvidence, path: string, whole: boolean): void {
  evidence.changed.add(path)
  if (whole) evidence.written.add(path)
  evidence.ordinal += 1
  evidence.lastChange = evidence.ordinal
}

/**
 * Record one check command that ran.
 * @param evidence - the turn's evidence record.
 */
export function recordCheck(evidence: TurnEvidence): void {
  evidence.ordinal += 1
  evidence.lastCheck = evidence.ordinal
}

/**
 * Merge line ranges into sorted ranges that neither overlap nor touch.
 * @param ranges - inclusive line ranges in any order.
 * @returns the merged ranges in ascending order.
 */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0])
  const merged: [number, number][] = []
  for (const [first, last] of sorted) {
    const tail = merged.at(-1)
    if (tail !== undefined && first <= tail[1] + 1) tail[1] = Math.max(tail[1], last)
    else merged.push([first, last])
  }
  return merged
}

/**
 * Count the lines of a file that merged ranges leave unread.
 * @param merged - merged ranges from {@link mergeRanges}.
 * @param totalLines - the file's line count.
 * @returns lines outside every range, never negative.
 */
export function unreadLines(merged: readonly LineRange[], totalLines: number): number {
  const covered = merged.reduce((sum, [first, last]) => sum + Math.max(0, Math.min(last, totalLines) - first + 1), 0)
  return Math.max(0, totalLines - covered)
}

/**
 * Decide what one completed turn should review.
 * @param evidence - the turn's evidence record.
 * @param thresholds - the deployment's review thresholds.
 * @returns the findings, or `undefined` when the turn warrants no review.
 */
export function collectFindings(evidence: TurnEvidence, thresholds: FindingThresholds): Findings | undefined {
  const partialReads: PartialRead[] = []
  for (const [path, { ranges, totalLines }] of evidence.reads) {
    if (evidence.written.has(path)) continue
    const read = mergeRanges(ranges)
    const unread = unreadLines(read, totalLines)
    if (unread >= thresholds.minUnreadLines) partialReads.push({ path, read, totalLines, unread })
  }
  const uncheckedChanges = evidence.lastChange > evidence.lastCheck ? [...evidence.changed] : []
  const substantial = evidence.toolCalls >= thresholds.reviewAfterToolCalls
  if (partialReads.length === 0 && uncheckedChanges.length === 0 && !substantial) return undefined
  return { partialReads, uncheckedChanges, toolCalls: evidence.toolCalls }
}

/**
 * Name at most {@link MAX_LISTED_FILES} items and count the rest.
 * @param items - rendered items in order.
 * @returns the items joined with commas, plus "and N more" when some were left out.
 */
function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED_FILES).join(', ')
  const rest = items.length - MAX_LISTED_FILES
  return rest > 0 ? `${shown}, and ${rest} more` : shown
}

/**
 * Render a file's read ranges as "lines A-B and C-D of N".
 * @param partial - one partly read file.
 * @returns the file path with its read ranges and line count.
 */
function describePartial(partial: PartialRead): string {
  const ranges = partial.read.map(([first, last]) => first === last ? `${first}` : `${first}-${last}`).join(' and ')
  return `${partial.path} (lines ${ranges} of ${partial.totalLines})`
}

/**
 * Render the review request the model receives for one turn's findings. The
 * claim check is always present, and the request always ends by asking for the
 * complete final answer again, so a host that prints the last reply prints the
 * reviewed answer.
 * @param findings - the findings from {@link collectFindings}.
 * @returns the review request text.
 */
export function renderReview(findings: Findings): string {
  const lines = ['Before you finish, check your work:']
  if (findings.partialReads.length > 0) {
    lines.push(`- You read only part of these files: ${listed(findings.partialReads.map(describePartial))}. `
      + 'Read the parts your answer depends on, or say which lines it covers.')
  }
  if (findings.uncheckedChanges.length > 0) {
    lines.push(`- You changed ${listed(findings.uncheckedChanges)} and ran no test, build, or lint command after the last change. `
      + 'Run the relevant check and fix any failure, or say why none applies.')
  }
  lines.push('- Check every claim in your answer against what you read or ran, and correct anything wrong or unverified.')
  lines.push('Then give your complete final answer again.')
  return lines.join('\n')
}

/**
 * Narrow an unknown value to a plain object.
 * @param value - any value.
 * @returns whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The line window in a `read` result's `meta`.
 * @param meta - the result's durable presentation payload.
 * @returns the path, inclusive line range, and line count; `undefined` when the meta carries no line window.
 */
export function readWindow(meta: unknown): { path: string; range: LineRange; totalLines: number } | undefined {
  if (!isRecord(meta) || typeof meta.path !== 'string' || typeof meta.totalLines !== 'number' || !Array.isArray(meta.lines)) return undefined
  const numbers = meta.lines.flatMap(line => isRecord(line) && typeof line.number === 'number' ? [line.number] : [])
  if (numbers.length === 0) return undefined
  return { path: meta.path, range: [Math.min(...numbers), Math.max(...numbers)], totalLines: meta.totalLines }
}

/**
 * The changed file in an `edit` or `write` result's `meta`.
 * @param meta - the result's durable presentation payload.
 * @returns the changed path and whether the whole file was written; `undefined` without a path.
 */
export function changedFile(meta: unknown): { path: string; whole: boolean } | undefined {
  if (!isRecord(meta) || typeof meta.path !== 'string') return undefined
  return { path: meta.path, whole: typeof meta.operation === 'string' }
}

/**
 * The command text a shell tool call carries.
 * @param args - the call's parsed arguments.
 * @returns the `command` string, or `undefined` when there is none.
 */
export function shellCommand(args: unknown): string | undefined {
  return isRecord(args) && typeof args.command === 'string' ? args.command : undefined
}
