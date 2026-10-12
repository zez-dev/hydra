/**
 * Pure helpers behind the `run_experiment` tool: metric extraction from a
 * command's output, deltas against the previous run of the same title, the
 * byte cap on the recorded output, and the result text written to the journal.
 * @module
 */

import type { ExperimentEntry, Journal } from './types.ts'

/** One metric to read out of a run's output. */
export interface MetricSpec {
  /** Metric name as recorded in the journal. */
  readonly name: string
  /** Regular expression; the first capture group, else the whole match, must parse as a number. */
  readonly regex: string
}

/** What one run produced, before it is rendered into the journal. */
export interface ExperimentOutcome {
  /** Process exit code; `null` when killed or timed out. */
  readonly exitCode: number | null
  readonly timedOut: boolean
  /** Metrics read from the output. */
  readonly metrics: Readonly<Record<string, number>>
  /** New minus previous for each shared metric. */
  readonly deltas: Readonly<Record<string, number>>
  /** The (possibly truncated) combined output. */
  readonly output: string
}

/**
 * Read named numeric metrics out of a run's output.
 * @param output - combined stdout and stderr.
 * @param specs - the metrics to look for.
 * @returns every metric whose pattern matched and parsed as a finite number.
 */
export function extractMetrics(output: string, specs: readonly MetricSpec[]): Record<string, number> {
  const metrics: Record<string, number> = {}
  for (const spec of specs) {
    let match: RegExpExecArray | null
    try {
      match = new RegExp(spec.regex, 'mu').exec(output)
    } catch {
      // An invalid pattern reads nothing; the tool reports which patterns were invalid separately.
      continue
    }
    if (match === null) continue
    const value = Number(match[1] ?? match[0])
    if (Number.isFinite(value)) metrics[spec.name] = value
  }
  return metrics
}

/**
 * Differences between two runs' metrics.
 * @param previous - the earlier run's metrics, or `undefined` for a first run.
 * @param current - this run's metrics.
 * @returns `current - previous` for every metric present in both.
 */
export function metricDeltas(
  previous: Readonly<Record<string, number>> | undefined,
  current: Readonly<Record<string, number>>,
): Record<string, number> {
  const deltas: Record<string, number> = {}
  if (previous === undefined) return deltas
  for (const [name, value] of Object.entries(current)) {
    const before = previous[name]
    if (before !== undefined) deltas[name] = Number((value - before).toPrecision(12))
  }
  return deltas
}

/**
 * Cap text at a UTF-8 byte budget.
 * @param text - the text.
 * @param maxBytes - the budget.
 * @returns the kept prefix and whether anything was dropped.
 */
export function truncateOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const buffer = Buffer.from(text).subarray(0, Math.max(0, maxBytes))
  return { text: buffer.toString('utf8').replace(/�+$/u, ''), truncated: true }
}

/**
 * The most recent experiment recorded under the same title.
 * @param journal - the journal.
 * @param title - the experiment title.
 * @returns the entry, or `undefined` when the title has not run before.
 */
export function previousExperiment(journal: Journal, title: string): ExperimentEntry | undefined {
  for (let index = journal.experiments.length - 1; index >= 0; index -= 1) {
    const entry = journal.experiments[index]
    if (entry?.title === title) return entry
  }
  return undefined
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
}

/**
 * Render a run's outcome as the journal's result text: exit status, each
 * metric with its delta, and an output excerpt.
 * @param outcome - the run's outcome.
 * @returns one line of result text.
 */
export function renderExperimentResult(outcome: ExperimentOutcome): string {
  const parts: string[] = []
  parts.push(outcome.timedOut ? 'timed out' : outcome.exitCode === null ? 'killed' : `exit ${outcome.exitCode}`)
  const names = Object.keys(outcome.metrics)
  if (names.length > 0) {
    parts.push(names.map((name) => {
      const delta = outcome.deltas[name]
      const value = formatNumber(outcome.metrics[name] ?? 0)
      return delta === undefined ? `${name}=${value}` : `${name}=${value} (Δ ${delta >= 0 ? '+' : ''}${formatNumber(delta)})`
    }).join(', '))
  }
  const excerpt = outcome.output.trim().replace(/\s+/gu, ' ')
  if (excerpt.length > 0) parts.push(`output: ${excerpt}`)
  return parts.join('; ')
}
